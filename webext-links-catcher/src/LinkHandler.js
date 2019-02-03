// Helper attached to a link that the catcher can target
// TODO: detect elements visibility change ?
// TODO: fix when node moves in page ? (e.g. 'floating' menu)

function LinkHandler(link) {
  // The link itself
  this.link = link;
  // The highlight zones, if any
  this.highlights = [];
}

// Whether this link can be caught
LinkHandler.prototype.canCatch = function() {
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
};

// Whether this link was caught (highlighted)
LinkHandler.prototype.isCaught = function() {
  return this.highlights.length > 0;
};

// Install handler
LinkHandler.prototype.install = function() {
  this.link.linksCatcher_handler = this;
};

// Resets handler
LinkHandler.prototype.reset = function() {
  for (var node of this.highlights) {
    node.parentNode.removeChild(node);
  }
  this.highlights = [];
};

// Catches link in zone
LinkHandler.prototype.catch = function(catchZone) {
  var intersect = false;
  for (var rect of this.rects) {
    intersect = intersect || ((rect.right > catchZone.left) && (rect.left < catchZone.right) &&
      (rect.bottom > catchZone.top) && (rect.top < catchZone.bottom));
    if (intersect) break;
  }
  return this.highlight(intersect ? this.rects : undefined);
};

// Changes link highlighting
LinkHandler.prototype.highlight = function(rects) {
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
};
