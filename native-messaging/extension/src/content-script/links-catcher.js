'use strict';

import { constants } from '../common/constants.js';
import * as util from '../common/util.js';
import { settings } from '../common/settings.js';


export async function run() {
  // We only work in top frame.
  if (!settings.catchLinks || (window !== window.top)) return;

  await util.waitForDocument();

  let link = document.createElement('link');
  link.href = browser.runtime.getURL('/resources/content-script-links-catcher.css');
  link.type = 'text/css';
  link.rel = 'stylesheet';
  document.head.appendChild(link);

  new LinksCatcher();
}


// Extension parameters, not important enough to be managed as stored settings.
let extParams = {
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
let debug;

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
  let viewWidth = document.documentElement.clientWidth;
  let viewHeight = document.documentElement.clientHeight;
  if (!document.doctype) {
    // When there is no DOCTYPE, use 'body' if it has a non-0 value.
    if (document.body.clientWidth > 0) viewWidth = document.body.clientWidth;
    if (document.body.clientHeight > 0) viewHeight = document.body.clientHeight;
  }

  return {
    viewWidth,
    viewHeight
  };
}

function getNodeRect(node) {
  let rect = node.getBoundingClientRect();
  // Take into account scroll position
  rect = new DOMRect(rect.x + window.scrollX, rect.y + window.scrollY, rect.width, rect.height);
  return rect;
}

function getNodeRects(node) {
  let rects = [];
  for (let rect of node.getClientRects()) {
    // Take into account scroll position
    rect = new DOMRect(rect.x + window.scrollX, rect.y + window.scrollY, rect.width, rect.height);
    rects.push(rect);
  }
  return rects;
}

function mergeRects(rect1, rect2) {
  let merge = false;

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
    let left = Math.min(rect1.left, rect2.left);
    let top = Math.min(rect1.top, rect2.top);
    let right = Math.max(rect1.right, rect2.right);
    let bottom = Math.max(rect1.bottom, rect2.bottom);
    return new DOMRect(left, top, right - left, bottom - top);
  }
}

function debugSample(kind) {
  if (!settings.debug.linksCatcher || extParams.debug.excluded.has(kind)) return FUNCTION_NOOP;

  let samples = extParams.debug.samples.kinds[kind];
  if (!samples) return debug;

  let now = util.epoch();
  if (samples.mark != now) {
    samples.mark = now;
    if (samples.skipped > 0) {
      debug(`[LinksCatcher] Skipped samples=<${samples.skipped}> kind=<${kind}>`);
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
    let style = getComputedStyle(this.link);
    if ((style.display == 'none') || (style.visibility == 'hidden')) return false;

    let rect = getNodeRect(this.link);
    this.hint = rect;
    this.refreshPosition(rect);
    return !!this.rects.length;
  }

  refreshPosition(rect) {
    this.refresh = false;
    let modified = false;
    if (!rect) {
      rect = getNodeRect(this.link);
      let hint = this.hint;
      this.hint = rect;
      modified = (rect.top != hint.top) || (rect.bottom != hint.bottom) || (rect.left != hint.left) || (rect.right != hint.right);
      if (!modified) return modified;
    }

    this.rects = [];
    let rects = [];
    let useLink = true;
    if (this.link.childElementCount) {
      // If one child does not fit the link, use the children.
      for (let child of this.link.children) {
        let childRect = getNodeRect(child);
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
      for (let child of this.link.children) {
        rects = rects.concat(getNodeRects(child));
      }
    }
    for (rect of rects) {
      let merged;
      if (rect.width || rect.height) {
        for (let rect0 of this.rects) {
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
      let xMin = Number.MAX_SAFE_INTEGER;
      let yMin = Number.MAX_SAFE_INTEGER;
      let xMax = Number.MIN_SAFE_INTEGER;
      let yMax = Number.MIN_SAFE_INTEGER;
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
    for (let node of this.highlights) {
      node.parentNode.removeChild(node);
    }
    this.highlights = [];
  }

  // Catches link in zone
  catch(catchZone) {
    let intersect = false;
    // Update position if needed and applicable.
    let updated = this.refresh && this.refreshPosition();
    for (let rect of this.rects) {
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
    let wasCaught = this.isCaught();
    let caught = !!rects;
    // Force redrawing link highlight when caught and its position was updated.
    if (caught && updated) this.reset();
    if (caught && (updated || !wasCaught)) {
      for (let rect of rects) {
        let node = document.createElement('div');
        this.highlights.push(node);
        node.classList.add('linksCatcher_highlight');
        node.style.left = `${rect.x}px`;
        node.style.top = `${rect.y}px`;
        node.style.width = `${rect.width}px`;
        node.style.height = `${rect.height}px`;
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

// Manages links while we catch them.
class LinksHandler {

  constructor(catcher) {
    let self = this;
    self.catcher = catcher;
    // Handled links.
    self.handlers = [];
    // Number of links actually caught.
    self.caught = 0;
    // Distincts caught links (per-url).
    self.distincts = {};
    // Whether we are currently catching links.
    self.enabled = false;

    // Mutation observer
    self.mutationObserver = new MutationObserver(function(mutations, observer) {
      for (let mutation of mutations) {
        self.handleMutation(mutation);
      }
    });
  }

  // Resets caught links
  reset() {
    for (let handler of this.handlers) {
      handler.reset();
    }
    this.distincts = {};
    this.caught = 0;
  }

  enable() {
    if (this.enabled) return;
    // Detect current links and observe mutations.
    // Handle mutations first, to ensure we will not miss any link.
    this.enabled = true;
    this.mutationObserver.observe(document.body, { childList: true, subtree: true });
    this.detect();
  }

  disable() {
    this.mutationObserver.disconnect();
    this.reset();
    this.handlers = [];
    this.enabled = false;
  }

  // Handles link
  handle(link) {
    let handler = new LinkHandler(link);
    if (!handler.canCatch()) return 0;
    handler.install();
    this.handlers.push(handler);
    this.check(handler);
  }

  // Detects all links in current document
  detect() {
    for (let node of searchLinks(document.body)) {
      this.handle(node);
    }
  }

  // Catches links in catch zone
  catch() {
    for (let handler of this.handlers) {
      this.check(handler);
    }
  }

  refresh(fast) {
    let updated = false;
    for (let handler of this.handlers) {
      // Upon fast refresh, skip if link was not previously caught.
      if (fast && !handler.isCaught()) continue;
      handler.refresh = true;
      if (this.check(handler)) updated = true;
    }
    if (updated) this.catcher.updateLinksCount();
  }

  check(handler) {
    this.updatedLink(handler, handler.catch(this.catcher.catchZone));
  }

  updatedLink(handler, diff) {
    this.caught += diff;
    let href = handler.link.href;
    if (diff > 0) {
      if (!(href in this.distincts)) this.distincts[href] = new Set();
      this.distincts[href].add(handler);
    } else if (diff < 0) {
      let set = this.distincts[href] || new Set();
      set.delete(handler);
      if (!set.size) delete(this.distincts[href]);
    }
  }

  // Handles (document) mutation: update known links in document
  handleMutation(mutation) {
    // Handle new links
    if (mutation.addedNodes.length) {
      for (let node of mutation.addedNodes) {
        for (let link of searchLinks(node)) {
          this.handle(link);
        }
      }
    }
    // Handle old links
    if (mutation.removedNodes.length) {
      for (let node of mutation.removedNodes) {
        for (let link of searchLinks(node)) {
          let handler = link.linksCatcher_handler;
          if (this.handlers.includes(handler)) {
            this.handlers.splice(this.handlers.indexOf(handler), 1);
            if (handler.isCaught()) this.updatedLink(handler, -1);
            handler.reset();
          }
        }
      }
    }
  }

}

// Actual links catcher
class LinksCatcher {

  constructor() {
    let self = this;

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
    let self = this;

    if (self.catchZone) return;
    debug('[LinksCatcher] Initializing');

    // Cleanup previous nodes if any (useful when reloading extension)
    for (let node of document.querySelectorAll('.linksCatcher_catchZone, .linksCatcher_linksCount')) {
      document.body.removeChild(node);
    }

    // Note: we want to scroll when the mouse goes beyond the view even if it
    // remains still. So we need to listen to 'mousemove' to keep the mouse last
    // position and periodically manage the last position.
    // Updating the catching zone can be done either for each received event, or
    // at the same time we handle scrolling, the latter being less consuming.

    self.linksHandler = new LinksHandler(self);

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
    self.linksCountNode = document.createElement('div');
    self.linksCountNode.classList.add('linksCatcher_linksCount');
    self.linksCountNode.style.display = 'none';
    document.body.appendChild(self.linksCountNode);

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
        let handler = self.eventHandlers[kind];
        self.eventHandlers[kind] = function(ev) {
          debugSample(ev.type)('[LinksCatcher] Event =', ev);
          handler(ev);
        };
      });
    }

    // Listen to mouse events
    ['mousedown', 'mouseup'].forEach(self.listenEvent.bind(self));
  }

  // Resets everything
  reset() {
    debug('[LinksCatcher.reset]');

    // Stop observing mutations and reset links
    this.linksHandler.disable();

    // Stop mouse tracking
    if (this.mouseTracking) {
      clearInterval(this.mouseTracking);
      delete(this.mouseTracking);
    }
    this.unlistenEvent('mousemove');

    // Reset catch zone
    delete(this.lastMouseEvent);
    this.updateCatchZone();
    this.catchZone.pos = {};

    // Re-enable user selection
    document.body.classList.remove('linksCatcher_noUserSelect');
  }

  // Updates catch zone: after mouse event etc.
  updateCatchZone() {
    let ev = this.lastMouseEvent;
    let startPos = this.catchZone.pos.start;

    // Page size.
    // See: http://ryanve.com/lab/dimensions/
    let pageWidth = document.documentElement.scrollWidth
    let pageHeight = document.documentElement.scrollHeight

    // Compute zone. Don't go beyond the page borders.
    let endPos;
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
      endPos = {
        x: Math.min(Math.max(window.scrollX + ev.clientX, 0), pageWidth),
        y: Math.min(Math.max(window.scrollY + ev.clientY, 0), pageHeight)
      };
    } else {
      endPos = { x: startPos.x, y: startPos.y };
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

    let viewWidth, viewHeight;
    if (this.catchZone.enabled || ev) {
      ({ viewWidth, viewHeight } = getViewportSize());
    }

    if (this.catchZone.enabled) {
      // Enable links handling when applicable.
      this.linksHandler.enable();
      this.catchZone.node.style.left = `${this.catchZone.left}px`;
      this.catchZone.node.style.top = `${this.catchZone.top}px`;
      this.catchZone.node.style.width = `${this.catchZone.width}px`;
      this.catchZone.node.style.height = `${this.catchZone.height}px`;
      this.catchZone.node.style.display = 'block';

      this.linksHandler.catch();
    } else {
      this.catchZone.node.style.display = 'none';
      this.linksHandler.reset();
    }
    this.updateLinksCount();

    if (!ev) return;
    // Check if we need to scroll (when the mouse is outside the view or near the screen edge).
    // Note: requesting scrolling when page edge has been reached is harmless.
    let screenWidth = window.screen.width;
    let screenHeight = window.screen.height;

    let scrollX = 0;
    if (ev.clientX < 0) {
      scrollX = ev.clientX;
    } else if (ev.clientX > viewWidth) {
      scrollX = ev.clientX - viewWidth;
    } else if (WINDOW_SCROLL_EDGE && (ev.screenX < WINDOW_SCROLL_EDGE)) {
      scrollX = (ev.screenX - WINDOW_SCROLL_EDGE);
    } else if (WINDOW_SCROLL_EDGE && (ev.screenX > screenWidth - WINDOW_SCROLL_EDGE)) {
      scrollX = ev.screenX - (screenWidth - WINDOW_SCROLL_EDGE);
    }

    let scrollY = 0;
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
      debugSample('scroll')(`[LinksCacther] Scroll x=<${scrollX}> y=<${scrollY}>`);
      window.scrollBy(scrollX, scrollY);
      this.refreshLinksPosition();
    }
  }

  // Updates displayed caught links count.
  updateLinksCount() {
    if (this.catchZone.enabled) {
      let endPos = this.catchZone.pos.end;
      let { viewWidth } = getViewportSize();
      let distincts = Object.keys(this.linksHandler.distincts).length;
      let caught = this.linksHandler.caught;
      let text = `${caught}`;
      if (distincts != caught) text = `${distincts}/${caught}`;
      this.linksCountNode.textContent = text;
      let rect = getNodeRect(this.linksCountNode);
      let left = endPos.x + LINKS_COUNT_MARGIN;
      let top = endPos.y - LINKS_COUNT_MARGIN - rect.height;
      if (left + rect.width + LINKS_COUNT_MARGIN > window.scrollX + viewWidth) {
        left = window.scrollX + viewWidth - rect.width - LINKS_COUNT_MARGIN;
      }
      if (top - LINKS_COUNT_MARGIN < window.scrollY) {
        top = window.scrollY + LINKS_COUNT_MARGIN;
      }
      this.linksCountNode.style.left = `${left}px`;
      this.linksCountNode.style.top = `${top}px`;
      this.linksCountNode.style.display = 'block';
    } else {
      this.linksCountNode.style.display = 'none';
    }
  }

  // Refreshes links position, for elements that do move inside page.
  // For uncaught links, ensure a minimal delay between two refresh: prevents
  // consuming too much CPU/time when there are hundreds of links in the page.
  refreshLinksPosition() {
    let self = this;
    let now = util.getTimestamp();
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
    if (!fast) {
      this.linksRefresh.last = util.getTimestamp();
      if (this.linksRefresh.timer) {
        clearTimeout(this.linksRefresh.timer);
        delete(this.linksRefresh.timer);
      }
    }
    this.linksHandler.refresh(fast);
  }

  // Processes caught links
  processLinks() {
    let handlers = [];
    let caught = [];
    // Keep caught links.
    for (let handler of this.linksHandler.handlers) {
      if (handler.isCaught()) handlers.push(handler);
    }
    // Sort links depending on catch zone direction (from top or bottom, and
    // from left or right).
    let topToBottom = this.catchZone.topToBottom;
    let leftToRight = this.catchZone.leftToRight;
    handlers.sort((h1, h2) => {
      let vertical = topToBottom ? (h1.rect.top - h2.rect.top) : (h2.rect.bottom - h1.rect.bottom);
      if (vertical != 0) return vertical;
      let horizontal = leftToRight ? (h1.rect.left - h2.rect.left) : (h2.rect.right - h1.rect.right);
      if (horizontal != 0) return horizontal;
    });
    // Keep unique links.
    for (let handler of handlers) {
      if (!caught.includes(handler.link.href)) caught.push(handler.link.href);
    }
    // Determine system-dependent newline.
    let newline = (navigator.appVersion.indexOf('Win') >= 0) ? '\r\n' : '\n';
    if (caught.length) navigator.clipboard.writeText(`${caught.join(newline)}${newline}`);
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
    let handler = this.eventHandlers[kind];
    if (handler) {
      debug(`[LinksCatcher] Listen event=<${kind}>`);
      document.addEventListener(kind, handler, true);
    } else {
      console.error(`[LinksCatcher] No handler to listen to event=<${kind}>`);
    }
  }

  // Removes event listener
  unlistenEvent(kind) {
    let handler = this.eventHandlers[kind];
    if (handler) {
      debug(`[LinksCatcher] Unlisten event=<${kind}>`);
      document.removeEventListener(kind, handler, true);
    }
  }

}
