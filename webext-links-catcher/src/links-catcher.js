// Helper attached to a link that the catcher can target
// TODO: detect elements visibility change ?
// TODO: fix when node moves in page ? (e.g. 'floating' menu)

class LinkHandler {

  constructor(link) {
    // The link itself
    this.link = link;
    // The highlight zones, if any
    this.highlights = [];
  }

  // Whether this link can be caught
  canCatch() {
    this.rects = [];
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

    var rects = [];
    var useLink = true;
    if (this.link.childElementCount) {
      // If one child does not fit the link, use the children.
      var rect = getNodeRect(this.link);
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
    for (var rect of rects) {
      var merged = undefined;
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

    return this.rects.length != 0;
  }

  // Whether this link was caught (highlighted)
  isCaught() {
    return this.highlights.length > 0;
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
    for (var rect of this.rects) {
      intersect = intersect || ((rect.right > catchZone.left) && (rect.left < catchZone.right) &&
        (rect.bottom > catchZone.top) && (rect.top < catchZone.bottom));
      if (intersect) break;
    }
    return this.highlight(intersect ? this.rects : undefined);
  }

  // Changes link highlighting
  highlight(rects) {
    // Notes:
    // The easier would be to apply a CSS style with outline+background without
    // altering the layout. But either the outline may not be visible (or somehow
    // cut), or the background hidden behind another element.
    // Creating a node with absolute position above the caught link gives a far
    // better visual result.
    // The zones where to create highlighting have been given as argument, or
    // none to reset highlighting.
    var caught = this.isCaught();
    if (rects && !caught) {
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
      // One more caught link
      return 1;
    } else if (!rects && caught) {
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
      if (settings.debug.enabled) {
        debugSample(ev.type)('[LinksCatcher] Event =', ev);
      }
      self.handleMouseDown(ev);
      if (self.catchZone !== undefined) {
        // We are now initialized, 'mousedown' is properly handled
        document.removeEventListener('mousedown', handler);
      }
    });
  }

  // Initializes the catcher
  init() {
    var self = this;

    if (this.catchZone !== undefined) return;
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
    // Mouse tracking id ('setInterval'/'clearInterval')
    this.mouseTracking = undefined;
    this.lastMouseEvent = undefined;

    // Mutation observer
    this.mutationObserver = new MutationObserver(function(mutations, observer) {
      for (var mutation of mutations) {
        self.handleMutation(mutation);
      }
    });

    // Create our catch zone
    this.catchZone = {
      'node': document.createElement('div')
    }
    this.catchZone.node.classList.add('linksCatcher_catchZone');
    this.catchZone.node.style.display = 'none';
    document.body.appendChild(this.catchZone.node);

    // Node to display number of caught links
    this.linksCount = {
      'node': document.createElement('div'),
      'value': 0
    }
    this.linksCount.node.classList.add('linksCatcher_linksCount');
    this.linksCount.node.style.display = 'none';
    document.body.appendChild(this.linksCount.node);

    // Functions to dispatch events to
    this.eventHandlers = {
      'mousedown': this.handleMouseDown.bind(this),
      'mouseup': this.handleMouseUp.bind(this),
      'mousemove': this.handleMouseMove.bind(this)
    };
    // Wrap handlers for debugging
    if (settings.debug.enabled) {
      // Note: beware of closure. A 'var' is locally defined for the enclosing
      // function. When used for anonymous functions, it's the value at the time
      // of calling which is used (not the value at the time the function was
      // built).
      // Hence it is better/easier to use 'forEach' than 'for...in'.
      // To iterate over keys, 'Object.keys(...)' is then necessary.
      Object.keys(this.eventHandlers).forEach(function(kind) {
        var handler = self.eventHandlers[kind];
        self.eventHandlers[kind] = function(ev) {
          debugSample(ev.type)('[LinksCatcher] Event =', ev);
          handler(ev);
        };
      });
    }

    // Listen to mouse events
    ['mousedown', 'mouseup'].forEach(this.listenEvent.bind(this));
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
    if (this.mouseTracking !== undefined) {
      clearInterval(this.mouseTracking);
      this.mouseTracking = undefined;
    }
    this.unlistenEvent('mousemove');
    // Some browsers don't have/need 'setCapture'/'releaseCapture'.
    if (document.releaseCapture) {
      document.releaseCapture();
    }

    // Reset catch zone
    this.lastMouseEvent = undefined;
    this.updateCatchZone();
    delete(this.catchZone.startPos);

    // Re-enable user selection
    document.body.classList.remove('linksCatcher_noUserSelect');
  }

  // Updates catch zone
  updateCatchZone() {
    var ev = this.lastMouseEvent;
    var startPos = this.catchZone.startPos;

    // Page size.
    // See: http://ryanve.com/lab/dimensions/
    var pageWidth = document.documentElement.scrollWidth
    var pageHeight = document.documentElement.scrollHeight

    // Compute zone. Don't go beyond the page borders.
    if (ev !== undefined) {
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
        'x': Math.min(Math.max(window.scrollX + ev.clientX, 0), pageWidth),
        'y': Math.min(Math.max(window.scrollY + ev.clientY, 0), pageHeight)
      };
    } else {
      var endPos = { 'x': startPos.x, 'y': startPos.y };
    }
    this.catchZone.left = Math.max(Math.min(startPos.x, endPos.x), 0);
    this.catchZone.top = Math.max(Math.min(startPos.y, endPos.y), 0);
    this.catchZone.right = Math.min(Math.max(startPos.x, endPos.x), pageWidth);
    this.catchZone.bottom = Math.min(Math.max(startPos.y, endPos.y), pageHeight);
    this.catchZone.width = this.catchZone.right - this.catchZone.left;
    this.catchZone.height = this.catchZone.bottom - this.catchZone.top;
    // Disable the catch zone if the mouse is almost at the starting point.
    // This way we don't do or override anything (especially the context menu)
    // when a simple click has been done for example.
    this.catchZone.enabled = (this.catchZone.width >= 4) && (this.catchZone.height >= 4);

    // Get viewport size.
    // See: https://stackoverflow.com/questions/1248081/get-the-browser-viewport-dimensions-with-javascript
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
    // So take the minimum of both elements, excluding unknown/0 values.
    if (this.catchZone.enabled || ev) {
      var clientWidth = Math.min(document.body.clientWidth || Number.MAX_SAFE_INTEGER, document.documentElement.clientWidth || Number.MAX_SAFE_INTEGER);
      var clientHeight = Math.min(document.body.clientHeight || Number.MAX_SAFE_INTEGER, document.documentElement.clientHeight || Number.MAX_SAFE_INTEGER);
    }

    if (this.catchZone.enabled) {
      if (this.linkHandlers === undefined) {
        // Detect current links and observe mutations
        this.detectLinks();
        this.mutationObserver.observe(document.body, { childList: true, subtree: true });
      }
      this.catchZone.node.style.left = this.catchZone.left + 'px';
      this.catchZone.node.style.top = this.catchZone.top + 'px';
      this.catchZone.node.style.width = this.catchZone.width + 'px';
      this.catchZone.node.style.height = this.catchZone.height + 'px';
      this.catchZone.node.style.display = 'block';

      this.catchLinks();
      this.linksCount.node.textContent = this.linksCount.value;
      var rect = getNodeRect(this.linksCount.node);
      var left = endPos.x + LINKS_COUNT_MARGIN;
      var top = endPos.y - LINKS_COUNT_MARGIN - rect.height;
      if (left + rect.width + LINKS_COUNT_MARGIN > window.scrollX + clientWidth) {
        left = window.scrollX + clientWidth - rect.width - LINKS_COUNT_MARGIN;
      }
      if (top - LINKS_COUNT_MARGIN < window.scrollY) {
        top = window.scrollY + LINKS_COUNT_MARGIN;
      }
      this.linksCount.node.style.left = left + 'px';
      this.linksCount.node.style.top = top + 'px';
      this.linksCount.node.style.display = 'block';
    } else {
      this.catchZone.node.style.display = 'none';
      this.linksCount.node.style.display = 'none';
      this.resetLinks();
    }

    if (ev === undefined) return;
    // Check if we need to scroll (when the mouse is outside the view or near the screen edge).
    // Note: requesting scrolling when page edge has been reached is harmless.
    var screenWidth = window.screen.width;
    var screenHeight = window.screen.height;

    var scrollX = 0;
    if (ev.clientX < 0) {
      scrollX = ev.clientX;
    } else if (ev.clientX > clientWidth) {
      scrollX = ev.clientX - clientWidth;
    } else if (WINDOW_SCROLL_EDGE && (ev.screenX < WINDOW_SCROLL_EDGE)) {
      scrollX = (ev.screenX - WINDOW_SCROLL_EDGE);
    } else if (WINDOW_SCROLL_EDGE && (ev.screenX > screenWidth - WINDOW_SCROLL_EDGE)) {
      scrollX = ev.screenX - (screenWidth - WINDOW_SCROLL_EDGE);
    }

    var scrollY = 0;
    if (ev.clientY < 0) {
      scrollY = ev.clientY;
    } else if (ev.clientY > clientHeight) {
      scrollY = ev.clientY - clientHeight;
    } else if (WINDOW_SCROLL_EDGE && (ev.screenY < WINDOW_SCROLL_EDGE)) {
      scrollY = (ev.screenY - WINDOW_SCROLL_EDGE);
    } else if (WINDOW_SCROLL_EDGE && (ev.screenY > screenHeight - WINDOW_SCROLL_EDGE)) {
      scrollY = ev.screenY - (screenHeight - WINDOW_SCROLL_EDGE);
    }

    if ((scrollX != 0) || (scrollY != 0)) {
      debugSample('scroll')('[LinksCacther] Scroll x=<%d> y=<%d>', scrollX, scrollY);
      window.scrollBy(scrollX, scrollY);
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
    this.linkHandlers = [];
    for (var node of searchLinks(document.body)) {
      this.handleLink(node);
    }
  }

  // Catches links in catch zone
  catchLinks() {
    for (var handler of this.linkHandlers) {
      this.linksCount.value += handler.catch(this.catchZone);
    }
  }

  // Processes caught links
  processLinks() {
    var caught = [];
    for (var handler of (this.linkHandlers || [])) {
      // Keep caught links and skip duplicates
      if (handler.isCaught() && !caught.includes(handler.link.href)) {
        caught.push(handler.link.href);
      }
    }
    if (caught.length) {
      navigator.clipboard.writeText(`${caught.join('\n')}\n`);
    }
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
    //if (ev.buttons != MOUSE_BUTTON_RIGHT) {
    //  return;
    //}
    if ((ev.buttons != MOUSE_BUTTON_LEFT) || !ev.shiftKey) {
      return;
    }
    this.init();
    this.skipContextMenu = (ev.buttons == MOUSE_BUTTON_RIGHT);
    // When using left button, disabling selection does not work well if there is
    // already some selected elements. Resetting the selection fixes it.
    if (ev.shiftKey) {
      window.getSelection().removeAllRanges();
      document.body.classList.add('linksCatcher_noUserSelect');
    }

    this.lastMouseEvent = ev;
    this.catchZone.startPos = { 'x': ev.pageX, 'y': ev.pageY };
    debug('[LinksCatcher.handleMouseDown] startPos=<%o>', this.catchZone.startPos);
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
    if (this.mouseTracking !== undefined) {
      clearInterval(this.mouseTracking);
    }
    this.mouseTracking = setInterval(this.updateCatchZone.bind(this), settings.mouseTrackingInterval);
  }

  // Handles 'mouseup': processes catch zone and resets catcher
  handleMouseUp(ev) {
    if (this.catchZone.startPos === undefined) {
      // No catch zone.
      return;
    }
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
    if (handler !== undefined) {
      debug('[LinksCatcher] Listen event=<%s>', kind);
      document.addEventListener(kind, handler, true);
    } else {
      console.error('[LinksCatcher] No handler to listen to event=<%s>', kind);
    }
  }

  // Removes event listener
  unlistenEvent(kind) {
    var handler = this.eventHandlers[kind];
    if (handler !== undefined) {
      debug('[LinksCatcher] Unlisten event=<%s>', kind);
      document.removeEventListener(kind, handler, true);
    }
  }

}
