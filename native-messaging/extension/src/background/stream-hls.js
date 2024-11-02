'use strict';

import * as util from '../common/util.js';


// See https://datatracker.ietf.org/doc/html/rfc8216
// We parse playlist content in order to determine master/stream ones.

// Tags that are followed by an URI line.
const tagWithURI = new Set(['EXTINF', 'EXT-X-STREAM-INF']);


// HLS entity with tags.
class HLSTagged {

  constructor() {
    this.tags = {};
  }

  addTag(tag) {
    let items = this.tags[tag.name];
    if (items === undefined) items = this.tags[tag.name] = [];
    items.push(tag);
  }

  getTag(name) {
    return this.getTags(name).at(0);
  }

  getTags(name) {
    return this.tags[name] || [];
  }

}

// HLS playlist.
export class HLSPlaylist extends HLSTagged {

  constructor(value, params) {
    super();
    params = params || {};
    this.raw = value;
    this.url = params.url;
    this.streams = [];
    this.parse(value, params);
    this.findStreams();
  }

  parse(value, params) {
    if (value === undefined) return;

    if (params.debug) console.log(`Parsing HLS content from=<${this.url}>`);

    // Split on EOL (LF or CRLF), trim and ignore empty or comment lines.
    let lines = value.split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => {
        return line.length && (
          (line[0] != '#') || line.startsWith('#EXT')
        );
      });

    // Ignore empty content.
    if (!lines) {
      if (params.debug) console.log('Ignore empty HLS content');
      return;
    }

    // First line must be the format identifier tag.
    let line = lines.shift();
    if (line != '#EXTM3U') {
      if (params.debug) console.log(`Ignore HLS content without format identifier tag in first line=<${line}>`);
      return;
    }

    while (lines.length) {
      line = lines.shift();
      if (line[0] != '#') {
        if (params.debug) console.log(`Ignore HLS non-tag line=<${line}>`);
        continue;
      }
      let tag = HLSPlaylist.parseTag(line);
      if (HLSPlaylist.tagNeedsURI(tag) && lines.length) {
        line = lines.shift();
        tag.uri = HLSPlaylist.parseURI(line);
        if (tag.uri === undefined) lines.unshift(line);
      }
      this.addTag(tag);
    }
  }

  findStreams() {
    for (let streamInf of this.getTags('EXT-X-STREAM-INF')) {
      let stream = new HLSStream({
        playlist: this,
        tag: streamInf
      });
      this.streams.push(stream);
    }
  }

  isStream() {
    if (this.streams.length) return;
    if (!this.getTags('EXTINF').length) return;
    return new HLSStream({
      uri: this.url,
      raw: this.raw,
      tags: this.tags
    });
  }

  getRenditions(groupId) {
    return this.getTags('EXT-X-MEDIA').filter(r => r.attributes['GROUP-ID'] == groupId);
  }

  static parseTag(line) {
    let parser = new HLSTagParser(line);

    let tag = {
      name: parser.parseTagName()
    };
    tag.value = parser.parseTagValue(tag);
    tag.attributes = parser.parseAttributes(tag);

    return tag;
  }

  static tagNeedsURI(tag) {
    return tagWithURI.has(tag.name);
  }

  static parseURI(line) {
    return (line[0] == '#') ? undefined : line;
  }

}

// HLS stream.
// Can be part of master playlist, or created from a non-master playlist.
class HLSStream extends HLSTagged {

  constructor(params) {
    super();
    Object.assign(this, params);
    if (!this.uri) this.uri = this.tag?.uri;
    this.determineName();
    this.determineDuration();
    this.video = this.determineRenditions('VIDEO');
    this.audio = this.determineRenditions('AUDIO');
    this.subtitles = this.determineRenditions('SUBTITLES');
  }

  merge(actual) {
    this.raw = actual.raw;
    this.tags = actual.tags;
    this.determineSize();
  }

  getURL() {
    return new URL(this.uri, this.playlist?.url);
  }

  getKeys() {
    return this.getTags('EXT-X-KEY').map(tag => {
      let method = tag.attributes['METHOD'];
      let url;
      if (method != 'NONE') url = new URL(tag.attributes['URI'], this.getURL()).href;
      return {
        method,
        url
      };
    });
  }

  determineName() {
    let name;
    let tag = this.tag;
    if (this.tag) {
      name = tag.attributes['NAME'];
      if (!name && tag.attributes['RESOLUTION']) {
        name = tag.attributes['RESOLUTION'].height;
        if (name) {
          name = `${name}p`;
          if (tag.attributes['FRAME-RATE']) {
            name = `${name}@${tag.attributes['FRAME-RATE']}`
          }
        }
      }
      // Bandwidth is in bits-per-second.
      if (!name && tag.attributes['AVERAGE-BANDWIDTH']) {
        name = `≈${util.getSizeText(tag.attributes['AVERAGE-BANDWIDTH'])}bps`;
      }
      if (!name && tag.attributes['BANDWIDTH']) {
        name = `≤${util.getSizeText(tag.attributes['BANDWIDTH'])}bps`;
      }
    } else {
      name = util.getFilenameExtension(util.getFilename(this.getURL())).name;
    }
    this.name = name;
  }

  determineDuration() {
    this.duration = this.getTags('EXTINF').map(tag => tag.value).reduce((sum, v) => sum + v, 0);
    if (this.duration <= 0) delete(this.duration);
  }

  determineSize() {
    this.determineDuration();
    if (!this.duration || !this.tag) return;

    // Bandwidth is in bits-per-second.
    if (this.tag.attributes['AVERAGE-BANDWIDTH']) {
      this.sizeHint = Math.round(this.duration * this.tag.attributes['AVERAGE-BANDWIDTH'] / 8);
      this.sizeDesc = `≈${util.getSizeText(this.sizeHint)}`;
    } else if (this.tag.attributes['BANDWIDTH']) {
      this.sizeHint = Math.round(this.duration * this.tag.attributes['BANDWIDTH'] / 8);
      this.sizeDesc = `≤${util.getSizeText(this.sizeHint)}`;
    }
  }

  determineRenditions(kind) {
    if (!this.tag ||!this.playlist) return [];
    let groupId = this.tag.attributes[kind];
    if (!groupId) return [];
    return this.playlist.getRenditions(groupId).map(r => new HLSTrack(this, r));
  }

}

// HLS track.
// Created from master playlist, associated to a stream.
class HLSTrack {

  constructor(stream, tag) {
    this.stream = stream;
    this.tag = tag;
    this.uri = this.tag.attributes['URI'];
    this.lang = this.tag.attributes['LANGUAGE'];
    this.determineName();
  }

  getURL() {
    return new URL(this.uri, this.stream.playlist.url);
  }

  determineName() {
    let tag = this.tag;
    let name = tag.attributes['NAME'];
    if (!name) name = tag.attributes['LANGUAGE'];
    this.name = name;
  }

}

export class HLSTagParser {

  constructor(value) {
    this.value = value.trim();
  }

  skipOffset(off, skipNext=1) {
    let v = this.value.substring(0, off).trim();
    this.value = this.value.substring(off + skipNext).trim();
    return v;
  }

  parseTagName() {
    let name;
    // Skip leading '#'.
    this.skipOffset(0);
    let idx = this.value.indexOf(':');
    if (idx < 0) {
      name = this.value;
      this.value = '';
    } else {
      name = this.skipOffset(idx);
    }
    return name;
  }

  parseTagValue(tag) {
    // Consider the tag value may be a quoted string too.
    let tagV = this.parseQuotedString();
    if (tagV === undefined) {
      tagV = '';
      // Tag main value (non-attributes) ends with first ',' unless it actually
      // is an attribute (contains '=').
      let idxComma = this.value.indexOf(',');
      let idxEqual = this.value.indexOf('=');
      if (idxComma < 0) {
        // At best there is one attribute.
        if (idxEqual < 0) {
          // Only tag value.
          tagV = this.value;
          this.value = '';
        } else {
          // There is no value, but one attribute.
        }
      } else {
        // There may be at least one attribute.
        if ((idxEqual < 0) || (idxEqual > idxComma)) {
          // There is a value and zero or more attribute(s) following.
          tagV = this.skipOffset(idxComma);
        } else {
          // There is no value, and at least one attribute.
        }
      }
    }

    let valueParser = tagValueParser[tag.name];
    if (!valueParser) valueParser = HLSTagParser.parseString;
    try {
      tagV = valueParser(tagV);
    } catch {}

    return tagV;
  }

  parseAttributes(tag) {
    let attributes = {};

    while (this.value.length) {
      let attName;
      let attValue = '';
      let idxComma = this.value.indexOf(',');
      let idxEqual = this.value.indexOf('=');
      if (idxComma < 0) {
        if (idxEqual < 0) {
          // value = 'XXX'
          // Should not happen, but consider the remaining value as attribute
          // name.
          attName = this.value;
          this.value = '';
        } else {
          // value = 'XXX=XXX'
          attName = this.skipOffset(idxEqual);
          attValue = this.parseAttributeValue();
          this.value = '';
        }
      } else {
        if ((idxEqual < 0) || (idxEqual > idxComma)) {
          // value = XXX,XXX
          // Should not happen, but consider the next part as attribute name.
          attName = this.skipOffset(idxComma);
        } else {
          // value = XXX=XXX,XXX
          attName = this.skipOffset(idxEqual);
          attValue = this.parseAttributeValue();
        }
      }

      let valueParser = tagAttributeParser[tag.name];
      if (valueParser) valueParser = valueParser[attName];
      if (!valueParser) valueParser = HLSTagParser.parseString;
      try {
        attValue = valueParser(attValue);
      } catch { }
      attributes[attName] = attValue;
    }

    return attributes;
  }

  parseAttributeValue() {
    let attValue = this.parseQuotedString();
    if (attValue === undefined) {
      let idxComma = this.value.indexOf(',');
      attValue = this.skipOffset((idxComma < 0) ? this.value.length : idxComma);
    }
    return attValue;
  }

  parseQuotedString() {
    if (!this.value.length || (this.value[0] != '"')) return undefined;

    // Quoted string ends on next quote.
    // Note: keep the quotes, caller will handle value type.
    let idx = this.value.indexOf('"', 1);
    if (idx < 0) {
      // No ending quote.
      // Should not happen: consider remaining text the value.
      return this.skipOffset(this.value.length);
    } else {
      let s = this.skipOffset(idx + 1, 0);
      if (this.value.length) {
        if (this.value[0] != ',') {
          // There are extra data after quote and before next parameter.
          // Should not happpen: ignore the extra data.
          let idxComma = this.value.indexOf(',');
          if (idxComma < 0) {
            this.value = '';
          } else {
            this.skipOffset(idxComma);
          }
        } else {
          // Skip ','.
          this.skipOffset(0);
        }
      }
      return s;
    }
  }

  static parseInteger(s) {
    if (!/^[0-9]+$/.test(s)) return 0;
    try {
      return parseInt(s);
    } catch { }
    try {
      return new BigInt(s);
    } catch { }
    return 0;
  }

  static parseDecimal(s) {
    try {
      let v = parseFloat(s);
      if (!isNaN(v)) return v;
    } catch { }
    return 0;
  }

  static parseString(s) {
    if (!s.length) return s;
    if ((s[0] == '"') && (s[s.length-1] == '"')) return s.substring(1, s.length-1);
    return s;
  }

  static parseBoolean(s) {
    return s == 'YES';
  }

  static parseResolution(s) {
    let res = {
      width: 0,
      height: 0
    };

    let idx = s.indexOf('x');
    if (idx > 0) {
      res.width = HLSTagParser.parseInteger(s.substring(0, idx));
      res.height = HLSTagParser.parseInteger(s.substring(idx + 1));
    }

    return res;
  }

}

// How to parse tag value, if non-string.
const tagValueParser = {
  'EXT-X-VERSION': HLSTagParser.parseInteger,
  'EXTINF': HLSTagParser.parseDecimal,
  'EXT-X-TARGETDURATION': HLSTagParser.parseInteger,
  'EXT-X-MEDIA-SEQUENCE': HLSTagParser.parseInteger
};

// How to parse tag attributes, if non-string.
const tagAttributeParser = {
  'EXT-X-STREAM-INF': {
    'BANDWIDTH': HLSTagParser.parseInteger,
    'AVERAGE-BANDWIDTH': HLSTagParser.parseInteger,
    'RESOLUTION': HLSTagParser.parseResolution,
    'FRAME-RATE': HLSTagParser.parseDecimal
  },
  'EXT-X-MEDIA': {
    'DEFAULT': HLSTagParser.parseBoolean,
    'AUTOSELECT': HLSTagParser.parseBoolean,
    'FORCED': HLSTagParser.parseBoolean
  }
};
