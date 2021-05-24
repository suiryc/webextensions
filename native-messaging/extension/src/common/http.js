'use strict';

import * as util from './util.js';
import { browserInfo, settings } from './settings.js';


// Checks whether an URL is considered downloadable.
// Tests the scheme for http(s).
export function canDownload(url) {
  var els = url.split(':');
  if (els < 2) return false;
  var scheme = els[0].toLowerCase();
  return ((scheme == 'http') || (scheme == 'https'));
}

export function findHeader(headers, name) {
  name = name.toLowerCase();
  return headers.find(h => h.name.toLowerCase() === name);
}

export function findHeaderValue(headers, name) {
  var header = findHeader(headers, name)
  if (header) return header.value;
}

// Gets cookie for given URL.
export function getCookie(url) {
  var search = {url};
  // 'firstPartyDomain' is useful/needed, but only exists in Firefox >= 59.
  // See: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/cookies/getAll
  if (browserInfo.version >= 59) search.firstPartyDomain = null;
  return browser.cookies.getAll(search).catch(error => {
    console.error('Failed to get %o cookies: %o', url, error);
    return [];
  }).then(cookies => {
    var cookie = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    return (cookie || undefined);
  });
}


export class RequestDetails {

  constructor(response) {
    this.received = response;
    this.url = response.url;
  }

  hasSize() {
    return Number.isInteger(this.contentLength);
  }

  hasFilename() {
    return !!this.filename;
  }

  parseResponse(interceptSize) {
    const response = this.received;
    var statusCode;
    var responseHeaders;
    if (!response.responseHeaders && response.headers) {
      // Assume we got a Fetch API Response.
      // Extract status and headers for proper handling.
      statusCode = response.status;
      responseHeaders = [];
      for (var h of response.headers) {
        responseHeaders.push({
          name: h[0],
          value: h[1]
        });
      }
    } else {
      // Assume we got standard webRequest details.
      statusCode = response.statusCode;
      responseHeaders = response.responseHeaders;
    }

    var contentLength;
    if (statusCode == 200) {
      // Get content length. Use undefined if unknown.
      contentLength = findHeaderValue(responseHeaders, 'Content-Length');
    }
    if (statusCode == 206) {
      // Determine content length through range response.
      var range = findHeaderValue(responseHeaders, 'Content-Range');
      if (range && (range.split(' ').shift().toLowerCase() === 'bytes')) {
        contentLength = range.split('/').pop().trim();
      } else {
        // Should not happen.
        if (settings.debug.misc) console.log('Ignoring unhandled Content-Range=<%s> in response=<%o>', range, response);
      }
    }
    // Only existing positive length is valid.
    // Note: comparing undefined to integer returns false.
    if (contentLength !== undefined) contentLength = Number(contentLength);
    if (contentLength >= 0) this.contentLength = contentLength;
    // Don't bother parsing other headers if content length is below limit.
    if (contentLength < interceptSize) return;

    // Get content type.
    this.contentType = new ContentType(findHeaderValue(responseHeaders, 'Content-Type'));

    // Get content disposition.
    this.contentDisposition = {
      raw: findHeaderValue(responseHeaders, 'Content-Disposition'),
      params: {}
    }
    if (this.contentDisposition.raw) {
      // See: https://tools.ietf.org/html/rfc6266
      // Examples:
      //  attachment
      //  inline; param1=value1; param2=value2 ...
      // Note: no 'comment' is expected in the value.
      var parser = new HeaderParser(this.contentDisposition.raw);
      this.contentDisposition.kind = parser.parseToken();
      this.contentDisposition.params = parser.parseParameters(true);
    }

    // Determine filename if given (i.e. not from URL).
    // Content-Disposition 'filename' is preferred over Content-Type 'name'.
    this.filename = this.contentDisposition.params.filename;
    if (!this.hasFilename()) this.filename = this.contentType.params.name;
    // Make sure to only keep filename (and no useless folder hierarchy).
    if (this.hasFilename()) {
      this.filename = this.filename.split(/\/|\\/).pop();
      // And guess mime type when necessary.
      this.contentType.guess(this.filename, false);
    }
    // Note: we don't guess filename from URL because we wish to know - for
    // later conditions testing - there was no explicit filename.
    // The external download application will do it anyway.
  }

}


export class ContentType {

  constructor(raw) {
    this.raw = raw || '';
    this.params = {};
    this.guessed = false;
    this.parse();
  }

  parse(keepParams) {
    if (!this.raw) return;

    // See: https://tools.ietf.org/html/rfc7231#section-3.1.1.5
    // Examples:
    //  mainType/subType
    //  mainType/subType; param1=value1; param2=value2 ...
    // Note: no 'comment' is expected in the value.
    var parser = new HeaderParser(this.raw);
    this.mimeType = parser.parseMediaType();
    if (!keepParams) this.params = parser.parseParameters(true);

    if (!this.mimeType) return;
    var els = this.mimeType.split('/');
    if (els.length != 2) return;
    this.mainType = els[0];
    this.subType = els[1];
  }

  needGuess() {
    return !this.subType || this.is('application', 'octet-stream');
  }

  guess(filename, ifNeeded) {
    if (ifNeeded && !this.needGuess()) return;
    if (!filename) return;
    var extension = util.getFilenameExtension(filename).extension || '';

    // We mainly care about text, images and audio.
    var guessed;
    if ('txt' == extension) guessed = 'text/plain';
    else if ('css' == extension) guessed = 'text/css';
    else if ('csv' == extension) guessed = 'text/csv';
    else if (/^html?$/.test(extension)) guessed = 'text/html';
    else if (/^m?js$/.test(extension)) guessed = 'text/javascript';
    else if ('xml' == extension) guessed = 'text/xml';
    else if (/^jpe?g$/.test(extension)) guessed = 'image/jpeg';
    else if ('png' == extension) guessed = 'image/png';
    else if ('webp' == extension) guessed = 'image/webp';
    else if ('gif' == extension) guessed = 'image/gif';
    else if ('bmp' == extension) guessed = 'image/bmp';
    else if (/^tiff?$/.test(extension)) guessed = 'image/tiff';
    else if (/^mp[1-3]$/.test(extension)) guessed = 'audio/mpeg';
    else if (/^m[12p]a$/.test(extension)) guessed = 'audio/mpeg';
    else if ('m4a' == extension) guessed = 'audio/mp4';
    else if ('weba' == extension) guessed = 'audio/webm';
    else if ('opus' == extension) guessed = 'audio/ogg';

    if (guessed) {
      this.raw = guessed;
      this.guessed = true;
      this.parse(true);
    }
  }

  is(mainType, subType) {
    return (!mainType || (mainType === this.mainType)) &&
      (!subType || (subType === this.subType));
  }

  isText() {
    // This is text if:
    // Main-type *is* text.
    if (this.is('text')) return true;
    // Sub-type starts with a well-known text type.
    if (!this.subType) return false;
    return (this.subType.startsWith('css')) ||
      (this.subType.startsWith('html')) ||
      (this.subType.startsWith('rss')) ||
      (this.subType.startsWith('text')) ||
      (this.subType.startsWith('xhtml')) ||
      (this.subType.startsWith('xml'));
  }

  isImage() {
    return this.is('image');
  }

  isAudio() {
    return this.is('audio');
  }

  maybeText() {
    // This may be text if either:
    //  - it *is* text.
    //  - there is a charset associated (why else give a charset ?).
    return this.isText() || !!this.params.charset;
  }

}


// Notes:
// Some headers (Content-Disposition and Content-Type) have a common structure,
// with possible parameters.
//
// RFC 6266
// --------
// Describes Content-Disposition HTTP header.
// https://tools.ietf.org/html/rfc6266#section-4.1
// -> Value is a token value followed by 0 or more parameters.
// RFC 2183 describes the same MIME header.
//
// RFC 7231
// --------
// Describes HTTP/1.1 semantics.
// https://tools.ietf.org/html/rfc7231#section-3.1.1.5
// -> Content-Type header
// RFC 2045 describes the same MIME header.
//
// RFC 7230
// --------
// Describes HTTP/1.1 syntax.
// https://tools.ietf.org/html/rfc7230#section-3.2.6
// -> Grammar
// RFC 5322 does the same for core MIME grammar.
//
// RFC 8187
// --------
// Describes non-US-ASCII character encoding in HTTP headers parameters.
// https://tools.ietf.org/html/rfc8187
// RFC 2231 does the same for MIME headers.
//
// We use some regular expressions to match specific patterns and remainder.
// To properly match multiline value, we need:
//  - the 'm' modifier
//  - [\s\S] to match any character
// See: https://stackoverflow.com/a/1981692

// Folding whitespace matcher.
// This actually only applies to MIME headers.
// RFC 5322
// https://tools.ietf.org/html/rfc5322#section-3.2.2
// For simplicity, use 'whitespace character' pattern instead of exact (as per
// RFC) matching.
const REGEX_FWS = /^(\s*)([\s\S]*)$/m;

// Token matcher.
// RFC 7230
// https://tools.ietf.org/html/rfc7230#section-3.2.6
// Any VCHAR, except delimiters - DQUOTE and "(),/:;<=>?@[\]{}"
const REGEX_TOKEN = /^([^\x00-\x20\x7F"\(\),\/:;<=>\?@\[\\\]\{\}]*)([\s\S]*)$/m;

export class HeaderParser {

  constructor(value) {
    this.value = value;
  }

  // Skips (and returns) next char.
  skipChar() {
    var char = this.value[0];
    this.value = this.value.substring(1);
    return char;
  }

  // Skips folding whitespace (FWS).
  // This actually only matters for MIME headers. But since such values should
  // not appear in HTTP we can still try to handle it - should do nothing much.
  // https://tools.ietf.org/html/rfc5322#section-3.2.2
  // Returns skipped value, reduced to a single space if a newline was found.
  skipFWS() {
    var fws = '';
    if (!this.value) return fws;
    var match = this.value.match(REGEX_FWS);
    if (match) {
      fws = (match[1].indexOf('\n') >= 0) ? ' ' : match[1];
      this.value = match[2];
    }
    return fws;
  }

  // Parses and returns next token.
  parseToken() {
    var token;
    this.skipFWS();
    if (!this.value) return;
    var match = this.value.match(REGEX_TOKEN);
    if (match && match[1]) {
      this.value = match[2];
      token = match[1];
    }
    this.skipFWS();
    return token;
  }

  // Parses an escaped string.
  // Ends at 'endChar', and handle optional recursion on 'recursiveChar'
  // (comments can embed comments).
  parseEscapedString(skipChar, endChar, recursiveChar) {
    var string = '';
    if (skipChar) this.skipChar();
    var recursiveLevel = 1;
    while (recursiveLevel > 0) {
      string += this.skipFWS();
      if (!this.value) break;
      var char = this.skipChar();
      if (char == endChar) {
        recursiveLevel--;
        continue;
      }
      if (char == recursiveChar) {
        string += recursiveChar;
        recursiveLevel++;
        continue;
      }
      if (char == '\\') string += this.skipChar();
      else string += char;
    }
    this.skipFWS();
    return string.trim();
  }

  // Skips next comment.
  skipComment() {
    this.skipFWS();
    if (!this.value) return;
    if (this.value[0] != '(') return;
    this.parseEscapedString(true, ')', '(');
    this.skipFWS();
  }

  // Parses and returns next string (token or quoted).
  // When applicable caller may indicate an end character: useful for parameter
  // values that are supposed to be either quoted strings or tokens, but are not
  // quoted strings while not respecting the 'token' definition (by containing
  // characters like '()' which are comments separators).
  // We don't strictly enforce the expected format, parsing as much as possible.
  parseString(endChar, skipEndChar) {
    var string;
    this.skipFWS();
    if (!this.value) return;
    if (this.value[0] == '"') {
      string = this.parseEscapedString(true, '"');
      if (endChar && this.value && (this.value[0] != endChar)) {
        var idx = this.value.indexOf(endChar);
        if (idx > 0) {
          string = `${string}${this.value.substring(0, idx).trim()}`;
          this.value = this.value.substring(idx);
        } else {
          string = `${string}${this.value.trim()}`;
          this.value = '';
        }
      }
    } else if (endChar) {
      string = this.parseEscapedString(false, endChar);
      // Re-prepend end character if needed
      if (!skipEndChar && this.value) this.value = `${endChar}${this.value}`;
    } else string = this.parseToken();
    this.skipFWS();
    return string;
  }

  // Parses parameter value.
  // Skips leading/trailing comment unless there is no comment expected: actually
  // only matters for MIME headers.
  parseValue(noComment) {
    var value;
    if (noComment) value = this.parseString(';');
    else {
       this.skipComment();
       value = this.parseString();
       this.skipComment();
    }
    return value;
  }

  // Decodes string according to found character set.
  // Only properly handles UTF-8 and latin1/iso-8859-1.
  decodeString(string) {
    var els = string.split('\'', 3);
    if (els.length != 3) return string;
    var charset = els[0].toLowerCase();
    string = els[2];
    // Value is URL-encoded.
    if (/^utf-?8$/.test(charset)) {
      // decodeURIComponent decodes UTF-8 URL-encoded values.
      try {
        string = decodeURIComponent(string);
      } catch (error) {
      }
    } else {
      // Otherwise, simply unescape the value.
      // Note: this only properly handles latin1/iso-8859-1 charsets.
      // A dedicated library (iconv and the like) would be needed to handle more
      // charsets. But in HTTP only UTF-8 is mandatory (and sensible to use).
      try {
        string = unescape(string);
      } catch (error) {
      }
    }
    return string;
  }

  // Parses next parameter (name=value).
  // Takes care of encoding.
  // Also handles continuations, which actually only matters for MIME headers
  // as discussed in RFC 8187.
  parseParameter(parameters, noComment) {
    var name = this.parseToken();
    if (!name) return;
    name = name.toLowerCase();

    // (MIME) If name contains/ends with '*' followed by an integer, the value
    // is actually split in an array and the integer gives the 0-based index.
    // If name ends with '*', value is encoded.
    var els = name.split('*');
    if (els.length > 3) return;
    name = els[0];
    var encoded = ((els.length > 1) && !els[els.length-1]);
    var section;
    if ((els.length > 1) && els[1]) {
      if (/^[0-9]*$/.test(els[1])) section = parseInt(els[1]);
      else return;
    }

    var parameter = parameters[name] || {};

    this.skipFWS();
    if (!this.value) return;
    if (this.value[0] != '=') return;
    this.skipChar();

    var value = this.parseValue(noComment);
    if (section !== undefined) {
      parameter.sections = parameter.sections || {};
      parameter.sections[section] = {
        encoded,
        value
      };
    } else {
      parameter.value = encoded ? this.decodeString(value) : value;
    }

    parameters[name] = parameter;
    return parameter;
  }

  // Parses parameters.
  parseParameters(noComment) {
    var self = this;
    var parameters = {};
    this.skipFWS();
    if (!this.value) return parameters;
    if (this.value[0] != ';') return parameters;
    this.skipChar();
    while (true) {
      if (!this.parseParameter(parameters, noComment)) break;
      if (!this.value) break;
      if (this.value[0] != ';') break;
      this.skipChar();
    }

    // (MIME) Handle any parameter split through continuations.
    // Also only keep parameters values.
    Object.keys(parameters).forEach(key => {
      var parameter = parameters[key];
      if (!parameter.sections) {
        parameters[key] = parameter.value;
        return;
      }
      var value = '';
      var idx = 0;
      var encoded = false;
      var valueTmp = '';

      var _flush = function() {
        value += encoded ? self.decodeString(valueTmp) : valueTmp;
      };

      while (true) {
        var section = parameter.sections[idx++];
        if (!section) break;
        if (section.encoded != encoded) {
          _flush();
          valueTmp = section.value;
          encoded = section.encoded;
        } else {
          valueTmp += section.value;
        }
      }
      _flush();
      delete(parameter.sections);
      parameters[key] = value;
    });

    return parameters;
  }

  // Parses media type (e.g. in Content-Type header)
  parseMediaType() {
    var mainType = this.parseToken();
    if (!mainType) return;
    if (!this.value) return;
    if (this.value[0] != '/') return;
    this.skipChar();
    var subType = this.parseToken();
    if (!subType) return;
    return `${mainType}/${subType}`;
  }

}


// RFC 6265 defines cookies
// See: https://datatracker.ietf.org/doc/html/rfc6265
//
// Each cookie is defined with a name-value-pair of the form 'name=value'.
// Cookies should not be nameless, neither in the form 'value' nor '=value'.
// However legacy implementations *may* use such forms, so try to cope with it.
//
// Even though the RFC asks to sort cookies (by path length and creation date),
// it also asks for server to NOT rely on any specific order.
// Here we try to keep the original cookie and order whenever possible.
//
// The RFC grammar does not allow spaces inside name and values, nor in leading
// or trailing positions. Legacy implementations may however use spaces.
// The RFC gives a permissive parsing algorithm that:
//  - trims leading/trailing spaces in name and value
//  - keeps spaces found inside name and value
//
// Quoting value only served to keep leading/trailing spaces in value.
// In particular there is no character escaping handled in cookies.

export class Cookie {

  // The given cookie string is parsed and remembered.
  // When cookies are removed/changed/added, the string representation is reset
  // and rebuilt when accessed.

  constructor(cookie) {
    this.cookie = cookie || undefined;
    this.cookies = [];
    if (cookie) {
      this.cookies = cookie.split(';').map(s => {
        s = s.trim();
        var split = s.split('=', 2).map(v => v.trim());
        return ((split.length < 2) || !split[0]) ? ['', this._decodeValue(s)] : [split[0], this._decodeValue(split[1])];
      });
    }
  }

  _decodeValue(s) {
    return (s.startsWith('"') && s.endsWith('"')) ? s.slice(1, -1) : s;
  }

  _encodeValue(s) {
    return (s.startsWith(' ') || s.endsWith(' ')) ? `"${s}"` : s;
  }

  value() {
    // Rebuild cookie string if necessary.
    if (!this.cookie && this.cookies.length) {
      this.cookie = this.cookies.map(a => {
        var name = a[0];
        var value = this._encodeValue(a[1]);
        return name ? `${name}=${value}` : value;
      }).join('; ');
    }
    return this.cookie;
  }

  find(name) {
    var cookie = this.cookies.find(a => a[0] == name);
    if (cookie) return cookie[1];
  }

  findAll(name) {
    return this.cookies.filter(a => a[0] == name).map(a => a[1]);
  }

  remove(name, first) {
    delete(this.cookie);
    var found = false;
    this.cookies = this.cookies.filter(a => {
      if (a[0] != name) return true;
      var keep = first && found;
      found = true;
      return keep;
    });
    return this;
  }

  add(name, value) {
    delete(this.cookie);
    this.cookies.push([name || '', value || '']);
    return this;
  }

  set(name, value, first) {
    delete(this.cookie);
    var found = false;
    var cookies = [];
    this.cookies.forEach(c => {
      if (c[0] != name) {
        cookies.push(c);
        return;
      }
      if (!found) cookies.push([name, value]);
      else if (first) cookies.push(c);
      found = true;
    });
    this.cookies = cookies;
    if (!found) this.add(name, value);
    return this;
  }

}
