'use strict';

import { constants } from '../common/constants.js';
import * as util from '../common/util.js';
import { settings } from '../common/settings.js';


// Handles received extension messages.
// Notes:
// 'async' so that we don't block and process the code asynchronously.
async function onMessage(extension, msg, sender) {
  switch (msg.kind || '') {
    case constants.KIND_CS_BROWSER_ACTION_POPUP_UPDATE:
      return updatePopup(msg);
      break;

    default:
      return unhandledMessage(msg, sender);
      break;
  }
}

// Logs unhandled messages received.
function unhandledMessage(msg, sender) {
  console.warn(`Browser action popup content script window=<${windowId}> tab=<${tabId}> frame=<${frameId}> received unhandled message %o from %o`, msg, sender);
  return {
    error: 'Message is not handled by browser popup content script',
    message: msg
  };
}

// Length of the arrow.
const ARROW_LENGTH = 7;
// Margin necessary to see the arrow, with optional breathing room.
const ARROW_MARGIN = ARROW_LENGTH + 0;
// Margin between the edge of the viewport and the edge of the popup.
const VIEWPORT_MARGIN = 3;

let popup;

function setupPopup() {
  // Use a unique container to host the Shadow DOM.
  // Remove any pre-existing container (e.g. extension was reloaded and content
  // script re-injected), to ensure we use an up-to-date content.
  let popupHost = document.getElementById('swe-browser-action-popup-container');
  if (popupHost) popupHost.remove();

  popupHost = document.createElement('div');
  popupHost.id = 'swe-browser-action-popup-container';
  // Ensure it does not affect layout.
  popupHost.style.display = 'block';
  popupHost.style.position = 'absolute';
  popupHost.style.top = '0';
  popupHost.style.left = '0';
  popupHost.style.width = '0';
  popupHost.style.height = '0';
  popupHost.style.overflow = 'visible';
  popupHost.style.zIndex = '2147483647';
  document.body.appendChild(popupHost);

  const shadow = popupHost.attachShadow({ mode: 'open' });

  // Inject the CSS.
  // Notice: browser cache does also work on links pointing to webextension
  // resources. So, changes in the file may not be seen even upon reloading the
  // page, and reopening the page in a new tab may be needed. Alternatively,
  // caching can be disabled in developer console.
  const link = document.createElement('link');
  link.href = browser.runtime.getURL('/resources/content-script-browser-action-popup.css');
  link.type = 'text/css';
  link.rel = 'stylesheet';
  shadow.appendChild(link);

  // Create the popup.
  popup = document.createElement('div');
  popup.style.setProperty('--arrow-length', `${ARROW_LENGTH}px`);
  popup.id = 'popup';
  popup.style.display = 'none';
  shadow.appendChild(popup);
}

function updatePopup(msg) {
  if (!popup) return;

  if (msg.action === 'hide') {
    popup.style.display = 'none';
    return;
  }

  const { title, subtitle } = msg.data;
  // Positions (absolute on screen) information:
  //  - containerLeft: left (x) of the container (browser action page)
  //  - itemTop: top (y) of the content selected item
  //  - itemMiddle: middle (y) of the content selected item
  let { containerLeft, itemTop, itemMiddle } = msg.pos;

  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  // IMPORTANT:
  // We need proper positioning of the popup element relatively to the container
  // (browser action page) being displayed. This is only possible by using the
  // Firefox-specific 'window.mozInnerScreenX/Y' which gives absolute screen
  // coordinates.
  containerLeft -= window.mozInnerScreenX;
  itemTop -= window.mozInnerScreenY;
  itemMiddle -= window.mozInnerScreenY;

  util.setHtml(popup, `
    <div class="popup-title">${title}</div>
    <div class="popup-subtitle">${subtitle}</div>
  `);

  // Leave as much width as possible for the popup:
  //  - start with the width available between the left edges of the viewport
  //    and the container (browser action page)
  //  - leave a margin on the left
  //  - leave a margin on the right, and enough space for the arrow pointing to
  //    the container selected item
  // Belt and suspenders: handle container displayed outside the viewport.
  let maxWidth = Math.floor(Math.min(containerLeft, viewportWidth) - VIEWPORT_MARGIN - Math.max(VIEWPORT_MARGIN, ARROW_MARGIN));
  popup.style.maxWidth = `${maxWidth}px`;

  // Height is constrained by viewport and margins at the top and bottom.
  const maxHeight = Math.floor(viewportHeight) - 2 * VIEWPORT_MARGIN;
  popup.style.maxHeight = `${maxHeight}px`;

  // Show the popup briefly with 'visibility: hidden' so that we can get its
  // actual dimensions.
  popup.style.display = 'block';
  popup.style.visibility = 'hidden';
  popup.style.left = '0px';
  popup.style.top = '0px';

  // Somehow, the popup width tend to be bigger (by 2 pixels) than the max width
  // we gave. Compensate maxWidth to have the wanted width.
  // Note: we don't need/want to for maxHeight.
  let actualWidth = popup.offsetWidth;
  if (actualWidth > maxWidth) {
    maxWidth -= Math.ceil(actualWidth - maxWidth);
    popup.style.maxWidth = `${maxWidth}px`;
    actualWidth = popup.offsetWidth;
  }
  const actualHeight = popup.offsetHeight;

  // Initial popup position:
  //  - left of the container, with room for the arrow
  //  - aligned on the top of the selected item
  let popupLeft = containerLeft - (actualWidth + ARROW_MARGIN);
  let popupTop = itemTop;

  // Move up popup if there is room and bottom is beyond viewport bottom margin.
  // Note: we will ensure top margin is enforced right below, so we can move
  // the popup up without concern here.
  if ((popupTop > VIEWPORT_MARGIN) && (popupTop + actualHeight > viewportHeight - VIEWPORT_MARGIN)) popupTop = viewportHeight - actualHeight - VIEWPORT_MARGIN;

  // Enforce margin on left and top of the viewport.
  if (popupLeft < VIEWPORT_MARGIN) popupLeft = VIEWPORT_MARGIN;
  if (popupTop < VIEWPORT_MARGIN) popupTop = VIEWPORT_MARGIN;

  popup.style.left = `${Math.floor(popupLeft)}px`;
  popup.style.top = `${Math.floor(popupTop)}px`;
  // Arrow should point to the middle of selected item.
  popup.style.setProperty('--arrow-top', `${Math.floor(itemMiddle - popupTop)}px`);
  popup.style.visibility = 'visible';
}

export async function run() {
  // We only run in the parent frame.
  if (frameId) return;

  if (!settings.video.intercept || !document.URL.startsWith('http')) return;

  await util.waitForDocument();

  setupPopup();
  webext.registerLocalTarget({
    id: constants.TARGET_ID_CONTENT_SCRIPT_BROWSER_ACTION_POPUP,
    onMessage
  });
}
