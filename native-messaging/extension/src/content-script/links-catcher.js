'use strict';

import { constants } from '../common/constants.js';
import * as util from '../common/util.js';
import { settings } from '../common/settings.js';


export async function run() {
  // We only work in top frame.
  if (window !== window.top) return;

  await settings.ready;
  if (!settings.catchLinks) return;
  await util.waitForDocument();

  var link = document.createElement('link');
  link.href = browser.extension.getURL('/resources/content-script-links-catcher.css');
  link.type = 'text/css';
  link.rel = 'stylesheet';
  document.head.appendChild(link);

  new LinksCatcher();
}


// Extension parameters, not important enough to be managed as stored settings.
var extParams = {
  'debug': {
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
  extParams.debug.samples.kinds[kind] = {
    // Last time (epoch) a sample was logged
    'mark': 0,
    // How many samples were skipped since last log
    'skipped': 0
  }
});

const FUNCTION_NOOP = function() {};

// Console log wrapper.
// See: https://stackoverflow.com/questions/13815640/a-proper-wrapper-for-console-log-with-correct-line-number
var debug;

function setupDebug() {
  debug = settings.debug.linksCatcher ? console.debug.bind(window.console) : FUNCTION_NOOP;
}

settings.debug.inner.linksCatcher.addListener(() => {
  setupDebug();
});
setupDebug();


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
  if (!document.doctype) {
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
}

function debugSample(kind) {
  if (!settings.debug.linksCatcher || extParams.debug.excluded.has(kind)) return FUNCTION_NOOP;

  var samples = extParams.debug.samples.kinds[kind];
  if (!samples) return debug;

  var now = util.epoch();
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

// Helper attached to a link that the catcher can target
// TODO: detect elements visibility change ?
// TODO: fix when node moves in page ? (e.g. 'floating' menu)
// TODO: handle nodes in inner frames ?

class LinkHandler {

  constructor(link) {
    // The link itself
    this.link = link;
    // The whole link rect.
    this.rect = new DOMRect(0, 0, 0, 0);
    // The highlight zones, if any
    this.highlights = [];
  }

  // Whether this link can be caught
  canCatch() {
    // See: https://stackoverflow.com/questions/19669786/check-if-element-is-visible-in-dom
    // See: https://stackoverflow.com/questions/178325/how-do-i-check-if-an-element-is-hidden-in-jquery/8266879#8266879

    // 'display: none': invisible, takes no space, not clickable.
    // 'visibility: hidden': invisible, takes place, not clickable.
    // 'opacity: 0': invisible, takes place, clickable.
    // Even though 'getComputedStyle' is 'slower', its speed is enough and we can
    // check more than 'display'.
    // Children with 'display: inline-block' can exist while actually being hidden
    // by parent. Getting the node size helps in this case.
    //
    // For simple links, checking dimension and 'display'/'visibility' is enough.
    // But links containing children may have a zero dimension while their
    // children may not.
    // Also a link may be split in multiple zones (e.g. a text on multiple lines).
    //
    // So we first check the link 'display'/'visibility' status to filter out
    // obviously hidden ones.
    // If the link has children, check whether their 'getBoundingClientRect' fit
    // the link. If not we get all the direct children 'getClientRects', otherwise
    // the link one.
    // We only keep rects with non-zero dimensions, and allow some simple merging
    // when possible.
    //
    // Note that some supposedly visible nodes may be hidden behind others.
    // A solution would be to determine 'center' of a node and check the element
    // at this position ('elementFromPoint') is the node itself or a child.
    // Unfortunately it only works for points in the current viewport.
    var style = getComputedStyle(this.link);
    if ((style.display == 'none') || (style.visibility == 'hidden')) return false;

    var rect = getNodeRect(this.link);
    this.hint = rect;
    this.refreshPosition(rect);
    return !!this.rects.length;
  }

  refreshPosition(rect) {
    this.refresh = false;
    if (!rect) {
      rect = getNodeRect(this.link);
      var hint = this.hint;
      this.hint = rect;
      var modified = (rect.top != hint.top) || (rect.bottom != hint.bottom) || (rect.left != hint.left) || (rect.right != hint.right);
      if (!modified) return modified;
    }

    this.rects = [];
    var rects = [];
    var useLink = true;
    if (this.link.childElementCount) {
      // If one child does not fit the link, use the children.
      for (var child of this.link.children) {
        var childRect = getNodeRect(child);
        if ((childRect.top < rect.top) || (childRect.bottom > rect.bottom) || (childRect.left < rect.left) || (childRect.right > rect.right)) {
          useLink = false;
          break;
        }
      }
    }
    // else: there is no children, so just use the link itself.
    if (useLink) {
      rects = getNodeRects(this.link);
    } else {
      for (var child of this.link.children) {
        rects = rects.concat(getNodeRects(child));
      }
    }
    for (rect of rects) {
      var merged;
      if (rect.width || rect.height) {
        for (var rect0 of this.rects) {
          merged = mergeRects(rect0, rect);
          if (merged) {
            this.rects.splice(this.rects.indexOf(rect0), 1);
            this.rects.push(merged);
            break;
          }
        }
        if (!merged) {
          this.rects.push(rect);
        }
      }
    }

    if (this.rects.length) {
      var xMin = Number.MAX_SAFE_INTEGER;
      var yMin = Number.MAX_SAFE_INTEGER;
      var xMax = Number.MIN_SAFE_INTEGER;
      var yMax = Number.MIN_SAFE_INTEGER;
      for (rect of this.rects) {
        if (rect.left < xMin) xMin = rect.left;
        if (rect.right > xMax) xMax = rect.right;
        if (rect.top < yMin) yMin = rect.top;
        if (rect.bottom > yMax) yMax = rect.bottom;
      }
      this.rect = new DOMRect(xMin, yMin, xMax - xMin, yMax - yMin);
    }

    return modified;
  }

  // Whether this link was caught (highlighted)
  isCaught() {
    return !!this.highlights.length;
  }

  // Install handler
  install() {
    this.link.linksCatcher_handler = this;
  }

  // Resets handler
  reset() {
    for (var node of this.highlights) {
      node.parentNode.removeChild(node);
    }
    this.highlights = [];
  }

  // Catches link in zone
  catch(catchZone) {
    var intersect = false;
    // Update position if needed and applicable.
    var updated = this.refresh && this.refreshPosition();
    for (var rect of this.rects) {
      intersect = intersect || ((rect.right > catchZone.left) && (rect.left < catchZone.right) &&
        (rect.bottom > catchZone.top) && (rect.top < catchZone.bottom));
      if (intersect) break;
    }
    return this.highlight(intersect ? this.rects : undefined, updated);
  }

  // Changes link highlighting
  highlight(rects, updated) {
    // Notes:
    // The easier would be to apply a CSS style with outline+background without
    // altering the layout. But either the outline may not be visible (or somehow
    // cut), or the background hidden behind another element.
    // Creating a node with absolute position above the caught link gives a far
    // better visual result.
    // The zones where to create highlighting have been given as argument, or
    // none to reset highlighting.
    var wasCaught = this.isCaught();
    var caught = !!rects;
    // Force redrawing link highlight when caught and its position was updated.
    if (caught && updated) this.reset();
    if (caught && (updated || !wasCaught)) {
      for (var rect of rects) {
        var node = document.createElement('div');
        this.highlights.push(node);
        node.classList.add('linksCatcher_highlight');
        node.style.left = rect.x + 'px';
        node.style.top = rect.y + 'px';
        node.style.width = rect.width + 'px';
        node.style.height = rect.height + 'px';
        // Note: since position is relative to the parent, we better add this node
        // to the body and not the catcher zone.
        document.body.appendChild(node);
      }
    }
    if (caught && !wasCaught) {
      // One more caught link
      return 1;
    } else if (!caught && wasCaught) {
      this.reset();
      // One less caught link
      return -1;
    }

    // No change
    return 0;
  }

}

// Actual links catcher
class LinksCatcher {

  constructor() {
    var self = this;

    // Don't initialize us before being needed
    document.addEventListener('mousedown', function handler(ev) {
      if (settings.debug.linksCatcher) {
        debugSample(ev.type)('[LinksCatcher] Event =', ev);
      }
      self.handleMouseDown(ev);
      if (self.catchZone) {
        // We are now initialized, 'mousedown' is properly handled
        document.removeEventListener('mousedown', handler);
      }
    });
  }

  // Initializes the catcher
  init() {
    var self = this;

    if (self.catchZone) return;
    debug('[LinksCatcher] Initializing');

    // Cleanup previous nodes if any (useful when reloading extension)
    for (var node of document.querySelectorAll('.linksCatcher_catchZone, .linksCatcher_linksCount')) {
      document.body.removeChild(node);
    }

    // Note: we want to scroll when the mouse goes beyond the view even if it
    // remains still. So we need to listen to 'mousemove' to keep the mouse last
    // position and periodically manage the last position.
    // Updating the catching zone can be done either for each received event, or
    // at the same time we handle scrolling, the latter being less consuming.

    // Mutation observer
    self.mutationObserver = new MutationObserver(function(mutations, observer) {
      for (var mutation of mutations) {
        self.handleMutation(mutation);
      }
    });

    self.linksRefresh = {
      last: 0
    };
    // Create our catch zone
    self.catchZone = {
      pos: {},
      node: document.createElement('div')
    }
    self.catchZone.node.classList.add('linksCatcher_catchZone');
    self.catchZone.node.style.display = 'none';
    document.body.appendChild(self.catchZone.node);

    // Node to display number of caught links
    self.linksCount = {
      node: document.createElement('div'),
      value: 0
    }
    self.linksCount.node.classList.add('linksCatcher_linksCount');
    self.linksCount.node.style.display = 'none';
    document.body.appendChild(self.linksCount.node);

    // Functions to dispatch events to
    self.eventHandlers = {
      mousedown: self.handleMouseDown.bind(self),
      mouseup: self.handleMouseUp.bind(self),
      mousemove: self.handleMouseMove.bind(self)
    };
    // Wrap handlers for debugging
    if (settings.debug.linksCatcher) {
      // Note: beware of closure. A 'var' is locally defined for the enclosing
      // function. When used for anonymous functions, it's the value at the time
      // of calling which is used (not the value at the time the function was
      // built).
      // Hence it is better/easier to use 'forEach' than 'for...in'.
      // To iterate over keys, 'Object.keys(...)' is then necessary.
      Object.keys(self.eventHandlers).forEach(function(kind) {
        var handler = self.eventHandlers[kind];
        self.eventHandlers[kind] = function(ev) {
          debugSample(ev.type)('[LinksCatcher] Event =', ev);
          handler(ev);
        };
      });
    }

    // Listen to mouse events
    ['mousedown', 'mouseup'].forEach(self.listenEvent.bind(self));
  }

  // Resets caught links
  resetLinks() {
    for (var handler of (this.linkHandlers || [])) {
      handler.reset();
    }
    this.linksCount.value = 0;
  }

  // Resets everything
  reset() {
    debug('[LinksCatcher.reset]');

    // Stop observing mutations and reset links
    this.mutationObserver.disconnect();
    this.resetLinks();
    if (this.linkHandlers) delete(this.linkHandlers);

    // Stop mouse tracking
    if (this.mouseTracking) {
      clearInterval(this.mouseTracking);
      delete(this.mouseTracking);
    }
    this.unlistenEvent('mousemove');
    // Some browsers don't have/need 'setCapture'/'releaseCapture'.
    if (document.releaseCapture) {
      document.releaseCapture();
    }

    // Reset catch zone
    delete(this.lastMouseEvent);
    this.updateCatchZone();
    this.catchZone.pos = {};

    // Re-enable user selection
    document.body.classList.remove('linksCatcher_noUserSelect');
  }

  // Updates catch zone: after mouse event etc.
  updateCatchZone() {
    var ev = this.lastMouseEvent;
    var startPos = this.catchZone.pos.start;

    // Page size.
    // See: http://ryanve.com/lab/dimensions/
    var pageWidth = document.documentElement.scrollWidth
    var pageHeight = document.documentElement.scrollHeight

    // Compute zone. Don't go beyond the page borders.
    if (ev) {
      // Note: don't use 'pageX'/'pageY' since when the mouse remain still it does
      // not take into account the scrolling we may trigger.
      // Instead compute the absolute position (in the page) from the relative
      // position in the current view.
      // Even though this - right now - may place the top (or bottom, depending on
      // the mouse position) outside the view, the scrolling we are about to
      // trigger will make it appear near the view edge.
      //
      // Since we are using endPos for other things, clamp it to the page size.
      // (displaying an element outside the current page size will make the page
      // grow, which would get ugly with our auto-scrolling triggering)
      var endPos = {
        x: Math.min(Math.max(window.scrollX + ev.clientX, 0), pageWidth),
        y: Math.min(Math.max(window.scrollY + ev.clientY, 0), pageHeight)
      };
    } else {
      var endPos = { x: startPos.x, y: startPos.y };
    }
    this.catchZone.pos.end = endPos;
    this.catchZone.left = Math.max(Math.min(startPos.x, endPos.x), 0);
    this.catchZone.top = Math.max(Math.min(startPos.y, endPos.y), 0);
    this.catchZone.right = Math.min(Math.max(startPos.x, endPos.x), pageWidth);
    this.catchZone.bottom = Math.min(Math.max(startPos.y, endPos.y), pageHeight);
    this.catchZone.width = this.catchZone.right - this.catchZone.left;
    this.catchZone.height = this.catchZone.bottom - this.catchZone.top;
    // Determine catch zone vertical/horizontal direction.
    this.catchZone.topToBottom = endPos.y >= startPos.y;
    this.catchZone.leftToRight = endPos.x >= startPos.x;
    // Disable the catch zone if the mouse is almost at the starting point.
    // This way we don't do or override anything (especially the context menu)
    // when a simple click has been done for example.
    this.catchZone.enabled = (this.catchZone.width >= 4) && (this.catchZone.height >= 4);

    if (this.catchZone.enabled || ev) {
      var { viewWidth, viewHeight } = getViewportSize();
    }

    if (this.catchZone.enabled) {
      if (!this.linkHandlers) {
        this.linkHandlers = [];
        // Detect current links and observe mutations.
        // Handle mutations first, to ensure we will not miss any link.
        this.mutationObserver.observe(document.body, { childList: true, subtree: true });
        this.detectLinks();
      }
      this.catchZone.node.style.left = this.catchZone.left + 'px';
      this.catchZone.node.style.top = this.catchZone.top + 'px';
      this.catchZone.node.style.width = this.catchZone.width + 'px';
      this.catchZone.node.style.height = this.catchZone.height + 'px';
      this.catchZone.node.style.display = 'block';

      this.catchLinks();
    } else {
      this.catchZone.node.style.display = 'none';
      this.resetLinks();
    }
    this.updateLinksCount();

    if (!ev) return;
    // Check if we need to scroll (when the mouse is outside the view or near the screen edge).
    // Note: requesting scrolling when page edge has been reached is harmless.
    var screenWidth = window.screen.width;
    var screenHeight = window.screen.height;

    var scrollX = 0;
    if (ev.clientX < 0) {
      scrollX = ev.clientX;
    } else if (ev.clientX > viewWidth) {
      scrollX = ev.clientX - viewWidth;
    } else if (WINDOW_SCROLL_EDGE && (ev.screenX < WINDOW_SCROLL_EDGE)) {
      scrollX = (ev.screenX - WINDOW_SCROLL_EDGE);
    } else if (WINDOW_SCROLL_EDGE && (ev.screenX > screenWidth - WINDOW_SCROLL_EDGE)) {
      scrollX = ev.screenX - (screenWidth - WINDOW_SCROLL_EDGE);
    }

    var scrollY = 0;
    if (ev.clientY < 0) {
      scrollY = ev.clientY;
    } else if (ev.clientY > viewHeight) {
      scrollY = ev.clientY - viewHeight;
    } else if (WINDOW_SCROLL_EDGE && (ev.screenY < WINDOW_SCROLL_EDGE)) {
      scrollY = (ev.screenY - WINDOW_SCROLL_EDGE);
    } else if (WINDOW_SCROLL_EDGE && (ev.screenY > screenHeight - WINDOW_SCROLL_EDGE)) {
      scrollY = ev.screenY - (screenHeight - WINDOW_SCROLL_EDGE);
    }

    if ((scrollX != 0) || (scrollY != 0)) {
      debugSample('scroll')('[LinksCacther] Scroll x=<%d> y=<%d>', scrollX, scrollY);
      window.scrollBy(scrollX, scrollY);
      this.refreshLinksPosition();
    }
  }

  // Updates displayed caught links count.
  updateLinksCount() {
    if (this.catchZone.enabled) {
      var endPos = this.catchZone.pos.end;
      var { viewWidth } = getViewportSize();
      this.linksCount.node.textContent = this.linksCount.value;
      var rect = getNodeRect(this.linksCount.node);
      var left = endPos.x + LINKS_COUNT_MARGIN;
      var top = endPos.y - LINKS_COUNT_MARGIN - rect.height;
      if (left + rect.width + LINKS_COUNT_MARGIN > window.scrollX + viewWidth) {
        left = window.scrollX + viewWidth - rect.width - LINKS_COUNT_MARGIN;
      }
      if (top - LINKS_COUNT_MARGIN < window.scrollY) {
        top = window.scrollY + LINKS_COUNT_MARGIN;
      }
      this.linksCount.node.style.left = left + 'px';
      this.linksCount.node.style.top = top + 'px';
      this.linksCount.node.style.display = 'block';
    } else {
      this.linksCount.node.style.display = 'none';
    }
  }

  // Handles link
  handleLink(link) {
    var handler = new LinkHandler(link);
    if (!handler.canCatch()) return 0;
    handler.install();
    this.linkHandlers.push(handler);
    return handler.catch(this.catchZone);
  }

  // Detects all links in current document
  detectLinks() {
    for (var node of searchLinks(document.body)) {
      this.linksCount.value += this.handleLink(node);
    }
  }

  // Catches links in catch zone
  catchLinks() {
    for (var handler of this.linkHandlers) {
      this.linksCount.value += handler.catch(this.catchZone);
    }
  }

  // Refreshes links position, for elements that do move inside page.
  // For uncaught links, ensure a minimal delay between two refresh: prevents
  // consuming too much CPU/time when there are hundreds of links in the page.
  refreshLinksPosition() {
    var self = this;
    var now = util.getTimestamp();
    if (now - self.linksRefresh.last >= LINKS_REFRESH_DELAY) {
      self._refreshLinksPosition(false);
      return;
    }
    // Immediately refresh caught links only, and enforce delay for other links.
    // This makes it visually nicer, while limiting CPU usage (and time needed).
    self._refreshLinksPosition(true);
    if (self.linksRefresh.timer) return;
    self.linksRefresh.timer = setTimeout(
      () => self._refreshLinksPosition(false),
      self.linksRefresh.last + LINKS_REFRESH_DELAY - now
    );
  }

  _refreshLinksPosition(fast) {
    var updated = false;
    if (!fast) {
      this.linksRefresh.last = util.getTimestamp();
      if (this.linksRefresh.timer) {
        clearTimeout(this.linksRefresh.timer);
        delete(this.linksRefresh.timer);
      }
    }
    for (var handler of this.linkHandlers) {
      if (fast && !handler.isCaught()) continue;
      handler.refresh = true;
      var diff = handler.catch(this.catchZone);
      this.linksCount.value += diff;
      if (diff) updated = true;
    }
    if (updated) this.updateLinksCount();
  }

  // Processes caught links
  processLinks() {
    var handlers = [];
    var caught = [];
    // Keep caught links.
    for (var handler of (this.linkHandlers || [])) {
      if (handler.isCaught()) handlers.push(handler);
    }
    // Sort links depending on catch zone direction (from top or bottom, and
    // from left or right).
    var topToBottom = this.catchZone.topToBottom;
    var leftToRight = this.catchZone.leftToRight;
    handlers.sort((h1, h2) => {
      var vertical = topToBottom ? (h1.rect.top - h2.rect.top) : (h2.rect.bottom - h1.rect.bottom);
      if (vertical != 0) return vertical;
      var horizontal = leftToRight ? (h1.rect.left - h2.rect.left) : (h2.rect.right - h1.rect.right);
      if (horizontal != 0) return horizontal;
    });
    // Keep unique links.
    for (var handler of handlers) {
      if (!caught.includes(handler.link.href)) caught.push(handler.link.href);
    }
    // Determine system-dependent newline.
    var newline = (navigator.appVersion.indexOf('Win') >= 0) ? '\r\n' : '\n';
    if (caught.length) navigator.clipboard.writeText(`${caught.join(newline)}${newline}`);
  }

  // Handles (document) mutation: update known links in document
  handleMutation(mutation) {
    // Handle new links
    if (mutation.addedNodes.length) {
      for (var node of mutation.addedNodes) {
        for (var link of searchLinks(node)) {
          this.linksCount.value += this.handleLink(link);
        }
      }
    }
    // Handle old links
    if (mutation.removedNodes.length) {
      for (var node of mutation.removedNodes) {
        for (var link of searchLinks(node)) {
          var handler = link.linksCatcher_handler;
          if (this.linkHandlers.includes(handler)) {
            this.linkHandlers.splice(this.linkHandlers.indexOf(handler), 1);
            if (handler.isCaught()) {
              this.linksCount.value--;
            }
            handler.reset();
          }
        }
      }
    }
  }

  // Handles 'mousedown': starts catch zone and follows mouse
  handleMouseDown(ev) {
    // Right button triggers context menu right away on Linux.
    //if (ev.buttons != constants.MOUSE_BUTTON_RIGHT) return;
    if ((ev.buttons != constants.MOUSE_BUTTON_LEFT) || !ev.shiftKey) return;
    this.init();
    this.skipContextMenu = (ev.buttons == constants.MOUSE_BUTTON_RIGHT);
    // When using left button, disabling selection does not work well if there is
    // already some selected elements. Resetting the selection fixes it.
    if (ev.shiftKey) {
      window.getSelection().removeAllRanges();
      document.body.classList.add('linksCatcher_noUserSelect');
    }

    this.lastMouseEvent = ev;
    this.catchZone.pos.start = { x: ev.pageX, y: ev.pageY };
    debug('[LinksCatcher.handleMouseDown] startPos=<%o>', this.catchZone.pos.start);
    this.updateCatchZone();

    // Note: setting capture on 'document.documentElement' is necessary to
    // receive 'mousemove' events from outside the page (and follow the mouse to
    // trigger scrolling). *BUT* it does not work if enabled from inside a
    // 'setTimeout' (at least under Firefox v56).
    // Some browsers don't have/need 'setCapture'/'releaseCapture'.
    if (document.documentElement.setCapture) {
      document.documentElement.setCapture(true);
    }

    // Start mouse tracking
    this.listenEvent('mousemove');
    // Sanity check
    if (this.mouseTracking) clearInterval(this.mouseTracking);
    this.mouseTracking = setInterval(this.updateCatchZone.bind(this), extParams.mouseTrackingInterval);
  }

  // Handles 'mouseup': processes catch zone and resets catcher
  handleMouseUp(ev) {
    // Ensure there is a catch zone.
    if (!this.catchZone.pos.start) return;
    this.lastMouseEvent = ev;
    this.updateCatchZone();
    if (this.skipContextMenu) {
      if (this.catchZone.enabled) {
        // Prevent context menu from appearing
        document.addEventListener('contextmenu', function handler(ev) {
          ev.preventDefault();
          ev.stopPropagation();
          document.removeEventListener('contextmenu', handler);
        });
      }
      this.skipContextMenu = false;
    }
    this.processLinks();
    this.reset();
  }

  // Handles 'mousemove': keep as last seen mouse event
  handleMouseMove(ev) {
    this.lastMouseEvent = ev;
  }

  // Adds event listener
  listenEvent(kind) {
    var handler = this.eventHandlers[kind];
    if (handler) {
      debug('[LinksCatcher] Listen event=<%s>', kind);
      document.addEventListener(kind, handler, true);
    } else {
      console.error('[LinksCatcher] No handler to listen to event=<%s>', kind);
    }
  }

  // Removes event listener
  unlistenEvent(kind) {
    var handler = this.eventHandlers[kind];
    if (handler) {
      debug('[LinksCatcher] Unlisten event=<%s>', kind);
      document.removeEventListener(kind, handler, true);
    }
  }

}
