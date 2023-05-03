# Scripts
All scripts are passed the following named parameters:
* `http`, `unsafe`, `util`: access to exported functions of each concerned module (from the `common` subfolder)
* `notif`: a [notifier](#notifier) for which each notification source is the script
* `webext`: the `WebExtension` instance

Then each script can pass its own additional parameters.

Script code can be synchronous (return value directly) or asynchronous (return a `Promise`).

Each script may return an object with (optional) fields to pass one or more values. Handled fields in returned object depends on the kind of script.  
If the executed script does return nothing, an empty object is returned to caller instead.


## `webRequest`

### `onBeforeSendHeaders`
The additional `params` object parameter is passed with the following content:
* `request`: the [request details](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/webRequest/onBeforeSendHeaders#details_2) being intercepted

As [documented](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/webRequest/BlockingResponse) the script can return an object containing the updated `requestHeaders` if changes are needed.


## Video

### _download refining_
The code is executed inside the frame containing the video source, and can be used to determine an actual (forced) URL to download instead of the original (possibly redirected) one.

The additional `params` object parameter is passed with the following content:
* `src`: (*string*) the video source URL

Handled fields in script returned object:
* `forceUrl`: (optional *string*) actual URL to use when downloading the video through the extension
* `filenameFromUrl`: (optional *boolean*) whether to extract video filename from the URL, instead of the page title

More generally the returned object is merged with other fields used to build the final VideoSource object.


### _filename refining_
The code is executed inside the background script and allows overriding the deduced video filename.

The additional `params` object parameter is passed with the following content:
* `videoSource`: the [`VideoSource`](#videosource) object for which we are refining the filename
* `title`: (*string*) the tab title
* `tabUrl`: (*string*) the tab URL
* `frameUrl`: (*string*) the frame URL
* `url`: (*string*) the current video source URL that would be downloaded through the extension
  * may be the redirected (when applicable) URL, or a forced (`videoSource.forceUrl`) URL determined during the _video download refining_ step
* `filename`: (*string*) the current filename (including extension) that would be used when saving the video
  * deduced from URL or tab title depending on `videoSource.filenameFromUrl`
* `name`: (*string*) the current file name
  * deduced from `filename`
* `extension`: (*string*) the current file extension
  * deduced from `filename`

The script may update the following fields in the `videoSource`:
* `filenameFromUrl` (optional *boolean*)

When applicable, these are used right after script execution to change the final filename to use.

Handled fields in script returned object:
* `filename`: (optional *string*) actual filename (extension included) to use
* `name`: (optional *string*) actual file name to use
* `extension`: (optional *string*) actual file extension to use
* `title`: (optional *string*)

If `filename` is returned, `name` and `extension` are deduced from the given value.  
If `name` and/or `extension` are returned, `filename` is rebuilt.  
If none of the `filename`, `name` and `extension` fields are returned, the original values (deduced from URL or tab title) are used.  
If `title` is returned, it is used instead of the tab title when deducing the filename from the tab title.

Note: if the page does send a request and the server response contains a filename, this filename will be used instead of the original or refined one.


# Objects

## Notifier
A notifier is passed a notification and does
* log it
* (optionally) display it as a browser notification
* pass it to be displayed through the extension icon in the browser toolbar

A notifier instance exposes 3 methods: `info`, `warn` and `error`.

Each method accepts a message to notify and an optional error object.  
Alternatively, an object can be passed with the following fields:
* `title`: (optional *string*) message title
* `message`: (*string*) message content
* `html`: (optional *boolean*) whether message and title are HTML or plain text
* `error`: (optional *object*) error associated to message
* `silent`: (optional *boolean*) whether to not display the notification as a browser notification


## `VideoSource`
A video source gathers information for a given source to download.

It may contain multiple URLs:
* the original one
* a redirected URL
* a forced URL: determined by the _video download refining_ script

Upon determining video filename, it also exposes two objects `downloadSite` and `tabSite`, containing parsed information from the URL (to download) and tab URL:
* `url`: (`URL` object) the concerned URL
* `hostname`: (*string*) the hostname part of the URL
* `nameParts`: (*string array*) hostname split on `.`
* `name`: (*string*) the second to last part of the hostname
* `pathParts`: (*string array*) the path split on `/`
