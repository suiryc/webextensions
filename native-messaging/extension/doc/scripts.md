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
* `namer`: the [`VideoSourceNamer`](#videosourcenamer) object with which we are refining the filename

The script interacts with the `namer` to get current naming and change it.  
Any returned value is ignored.

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

Some fields and methods that may be useful upon refining filename:
* `tabUrl`: (*string*) the tab URL with which the source is associated
* `tabTitle`: (*string*) the tab title
* `frameUrl`: (*string*) the frame URL the source comes from
* `url`: (*string*) the original video source URL
* `getUrl()`: (*string*) the current download URL, which may be
  * redirected URL: determined by intercepting requests responses
  * forced URL (`forceUrl`): determined during the _video download refining_ step
* `tabSite`: (*object*) information parsed from tab URL
* `downloadSite`: (*object*) information parsed from download URL

The objects `downloadSite` and `tabSite` contains these information:
* `url`: (`URL` object) the concerned URL
* `hostname`: (*string*) the hostname part of the URL
* `nameParts`: (*string array*) hostname split on `.`
* `name`: (*string*) the second to last part of the hostname
* `pathParts`: (*string array*) the path split on `/`


## `VideoSourceNamer`
A namer allows interacting with the filename to which a video would be downloaded through the extension.

These fields are useful to refine filename:
* `filename`: (*string*) the current filename (including extension) that would be used when saving the video
  * initially deduced from URL
* `name`: (*string*) the current file name
  * initially deduced from `filename`
* `extension`: (*string*) the current file extension
  * initially deduced from `filename`
* `title`: (*string*) the current title
  * initially the tab title
* `filenameFromUrl`: (optional *boolean*) whether download filename is based on namer `filename` or `title`
  * its initial value, when defined, is determined during the _video download refining_ step
  * script can change this field value, which is used right after script execution to get the final filename to use
  * when final filename is based on `title`, its value is set in `name` and the `extension` is suffixed to set the final `filename` value


### `filename` refining
Note: there is no use refining the `title` if `filenameFromUrl` is `true`.


#### `setFilename(filename)`
Changes `filename`.  
`name` and `extension` are deduced again from the new value.

**Parameters**
- `filename` (*string*): filename to set


#### `setName(name)`
Changes `name`.  
`filename` is rebuilt from the new value and `extension`.

**Parameters**
- `name` (*string*): name to set


#### `setExtension(extension)`
Changes `name`.  
`filename` is rebuilt from `name` and the new value.

**Parameters**
- `extension` (*string*): extension to set


### `title` refining

#### _title ending part_
A few methods are dealing with _title ending part_.

For these methods, a list of separators is used to extract the _ending part_ of the title: for each separator, if found in the title, the title is split and its last part is processed (action depends on the method purpose).  
The nominal list of separators is `[' - ', ' | ']`.  
All related methods accept optional parameters through a `params` object:
- `separators`: (*string array*) separators to use instead of nominal ones
- `extraSeparators`: (*string array*) more separators to use after nominal ones


#### `titleStripEndPart(str, params)`
If the [last part](#title-ending-part) of the title matches the given string, it is removed.  
The comparison is case-insensitive.

**Parameters**
- `str` (*string*): string to match
- `params` (*object*): optional parameters
  - parameters related to [title ending part](#title-ending-part) processing
  - `withoutSpaces`: (*boolean*) whether to ignore all whitespaces when comparing given string and title ending part


#### `titleStripEndPartRegexp(regexp, params)`
If the [last part](#title-ending-part) of the title matches the given regular expression, it is removed.  

**Parameters**
- `regexp` (*regular expression*): regular expression to match
- `params` (*object*): optional parameters
  - parameters related to [title ending part](#title-ending-part) processing


#### `titleStripRegexp(regexp, params)`
Strips portions of the title matched but not captured by a regular expression.  
If the regular expression matches, the remaining title is built by concatenating:
- the part preceding the match
- all groups captured by the regular expression
- the part following the match

**Parameters**
- `regexp` (*regular expression*): regular expression to match
- `params` (*object*): optional parameters
  - none for now


#### `titleStripDomain(params)`
If the [last part](#title-ending-part) of the title matches the site domain name, it is removed.  
For a given `sub2.sub1.sitename.tld` hostname, if the title last part matches either `sub1.sitename.tld`, `sitename.tld` or `sitename`, it is removed.  
This method relies on `titleStripEndPart`.

**Parameters**
- `str` (*string*): string to match
- `params` (*object*): optional parameters
  - parameters related to [title ending part](#title-ending-part) processing
  - `names`: (*string array*) more names to test after site name
  - `withoutSpaces`: (*boolean*) whether to ignore all whitespaces when comparing site name and title ending part
    - `true` by default if not given: e.g. if the title last part is `Site Name`, it will match `sitename` and be removed


#### `titleAppend(str, sep)`
Appends a string to the title, separated by a given separator.

**Parameters**
- `str`: (*string*) string to append to title
- `sep`: (*optional string*) separator to use between current title and appended string
  - a single space is used by default
  - ignored if the current title is empty
